/* Backup & Disaster Recovery - Restore. The exact inverse of exportData.js's
   "Export All": reads a previously-exported workbook back in and writes
   rows to Supabase, in a fixed dependency order (parents before children),
   remapping each parent's OLD numeric id to its newly-assigned NEW id
   before inserting any child row that references it - export column names
   already equal DB column names (exportData.js never renames anything for
   readability), so no fuzzy column-mapping UI is needed here, unlike the
   general Import wizard.

   ADDITIVE ONLY - this never updates or deletes an existing row. It exists
   to rebuild an empty or damaged project from a prior export, not to merge
   into a project that still has live data (that would create duplicates,
   stated plainly in the Settings UI, not silently handled). */
window.App = window.App || {};

App.restoreData = (function () {
  // Same 31-char/unsafe-char sheet-naming rule exportData.js's own
  // safeSheetName() uses - duplicated here (not exported from exportData.js)
  // since it's two lines and this is the only other place that needs it.
  function safeSheetName(label) {
    return label.replace(/[:\\/?*[\]]/g, '').slice(0, 31);
  }

  // Fixed dependency order (parents before children). Every table here is
  // written via App.api.restoreInsertRow, never the friendly createX
  // wrappers a manual-entry form would use - those wrappers carry side
  // effects (auto schedule generation, auto future-occurrence generation,
  // fn_record_payment's deal-state recompute) appropriate for FRESH entry,
  // exactly wrong for restoring already-complete historical data where the
  // exported row already reflects whatever that side effect produced the
  // first time, for real, in the past.
  const RESTORE_ORDER = [
    { key: 'platforms', label: 'Platforms', table: 'platforms', fk: {} },
    { key: 'deals', label: 'Deals', table: 'deals', fk: { platform_id: 'platforms' } },
    { key: 'payment_schedule', label: 'Payment Schedule', table: 'payment_schedule', fk: { deal_id: 'deals' } },
    { key: 'payments', label: 'Payments', table: 'payments', fk: { deal_id: 'deals', scheduled_payment_id: 'payment_schedule' } },
    { key: 'recurring_items', label: 'Recurring Items', table: 'recurring_items', fk: {} },
    { key: 'recurring_occurrences', label: 'Recurring Occurrences', table: 'recurring_occurrences', fk: { recurring_item_id: 'recurring_items' } },
    { key: 'gold_purchases', label: 'Gold Purchases', table: 'gold_purchases', fk: {} },
    { key: 'accounts', label: 'Accounts', table: 'accounts', fk: {} },
    { key: 'liabilities', label: 'Liabilities', table: 'liabilities', fk: {} },
    { key: 'contacts', label: 'Contacts', table: 'contacts', fk: {}, ownerCol: 'owner_user_id' },
    { key: 'expense_projects', label: 'Expense Projects', table: 'expense_projects', fk: {} },
    { key: 'expense_vendors', label: 'Expense Vendors', table: 'expense_vendors', fk: { linked_contact_id: 'contacts' } },
    // expense_advances restored BEFORE expense_transactions (not the export
    // sheet order) so a transaction's advance_id can be remapped too - it
    // only needs project_id/vendor_id, both already restored by this point.
    { key: 'expense_advances', label: 'Expense Advances', table: 'expense_advances', fk: { project_id: 'expense_projects', vendor_id: 'expense_vendors' } },
    // category_id is dropped, not remapped - expense_categories isn't an
    // export/restore section (nullable column, so a restored transaction
    // just loses its category assignment - a disclosed, acceptable gap,
    // unlike platforms which would have broken deal restoration outright).
    { key: 'expense_transactions', label: 'Expense Transactions', table: 'expense_transactions', fk: { project_id: 'expense_projects', vendor_id: 'expense_vendors', advance_id: 'expense_advances' }, dropCols: ['category_id'] },
    { key: 'notes', label: 'Notes', table: 'notes', fk: {} },
    { key: 'goals', label: 'Goals', table: 'portfolio_goals', fk: {} },
    { key: 'tax_records', label: 'Tax Records', table: 'tax_records', fk: {} },
  ];

  // Sections a full export contains but this Restore deliberately never
  // writes - shown in the UI, permanently unchecked/disabled, each with its
  // own one-line reason rather than silently vanishing.
  const EXCLUDED = [
    { key: 'documents', label: 'Documents', reason: "Files live in Supabase Storage, not in this export - restoring metadata-only rows would leave dangling references to files that aren't there." },
    { key: 'audit_logs', label: 'Audit History', reason: 'System-write-only by design - restoring old entries as "new" would misrepresent when they actually happened.' },
    { key: 'imports', label: 'Import History', reason: 'A log of past import runs, not portfolio holdings.' },
  ];

  function findSheet(workbook, label) {
    const target = safeSheetName(label);
    return workbook.SheetNames.find((n) => n === target) || null;
  }

  function readSheetRows(workbook, sheetName) {
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
  }

  // exportData.js's own cleanRows() JSON.stringifies any jsonb/array field
  // before writing it to a cell (a nested object/array would otherwise
  // render as "[object Object]") - this is the inverse step: any string
  // value that looks like JSON gets parsed back into a real array/object
  // before insert, so a column like contacts.tags (text[]) doesn't get a
  // literal stringified-JSON string written into it.
  function reviveJsonLike(row) {
    const out = {};
    Object.entries(row).forEach(([k, v]) => {
      if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
        try { out[k] = JSON.parse(v); return; } catch (e) { /* not actually JSON - keep as plain text */ }
      }
      out[k] = v;
    });
    return out;
  }

  // Inspects an uploaded workbook against RESTORE_ORDER + EXCLUDED, for the
  // Settings UI's per-section checklist (row counts, restorable vs. not).
  function inspectWorkbook(workbook) {
    const restorable = RESTORE_ORDER.map((section) => {
      const sheetName = findSheet(workbook, section.label);
      return { key: section.key, label: section.label, sheetName, rowCount: sheetName ? readSheetRows(workbook, sheetName).length : 0, found: !!sheetName };
    });
    const excluded = EXCLUDED.map((section) => {
      const sheetName = findSheet(workbook, section.label);
      return { key: section.key, label: section.label, sheetName, rowCount: sheetName ? readSheetRows(workbook, sheetName).length : 0, found: !!sheetName, reason: section.reason };
    });
    return { restorable, excluded };
  }

  // Runs the actual restore for the caller-selected section keys, in
  // RESTORE_ORDER's fixed sequence regardless of the order selectedKeys was
  // passed in. onProgress(resultsSoFar) fires after each section finishes.
  async function runRestore(workbook, selectedKeys, onProgress) {
    const idMapByTable = {}; // { [dbTableName]: { [oldId]: newId } }
    const results = [];
    for (const section of RESTORE_ORDER) {
      if (!selectedKeys.includes(section.key)) continue;
      const sheetName = findSheet(workbook, section.label);
      if (!sheetName) { results.push({ key: section.key, label: section.label, found: false, ok: 0, failed: 0 }); continue; }
      const rows = readSheetRows(workbook, sheetName);
      const keyMap = idMapByTable[section.table] = idMapByTable[section.table] || {};
      let ok = 0, failed = 0;
      for (const raw of rows) {
        const oldId = raw.id;
        let row = reviveJsonLike(raw);
        (section.dropCols || []).forEach((c) => { delete row[c]; });
        Object.entries(section.fk).forEach(([col, parentTable]) => {
          if (row[col] != null) {
            const parentMap = idMapByTable[parentTable] || {};
            row[col] = Object.prototype.hasOwnProperty.call(parentMap, row[col]) ? parentMap[row[col]] : null;
          }
        });
        try {
          const inserted = await App.api.restoreInsertRow(section.table, row, section.ownerCol ? { ownerCol: section.ownerCol } : undefined);
          if (oldId != null && inserted) keyMap[oldId] = inserted.id;
          ok++;
        } catch (e) { failed++; }
      }
      results.push({ key: section.key, label: section.label, found: true, ok, failed });
      if (onProgress) onProgress(results.slice());
    }
    return results;
  }

  return { RESTORE_ORDER, EXCLUDED, inspectWorkbook, runRestore };
})();
