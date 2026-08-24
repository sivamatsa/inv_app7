/* Data export - the exact inverse of imports.js's own XLSX.utils.
   sheet_to_json read path, using the same CDN-loaded XLSX global (no new
   dependency). Entirely client-side against already-fetched, already-RLS-
   scoped data - there's nothing here a user couldn't already see in the
   app, just reshaped into a spreadsheet. Scope: portfolio-data sections
   get their own per-view Export button; "Export All My Data" bundles all
   of them (plus a couple of history/audit sections not worth their own
   button) into one workbook, one sheet per section. */
window.App = window.App || {};

App.exportData = (function () {
  const SECTIONS = {
    platforms: { label: 'Platforms', fetch: () => App.api.listPlatforms() },
    deals: { label: 'Deals', fetch: () => App.api.listDeals() },
    payment_schedule: { label: 'Payment Schedule', fetch: () => App.api.listSchedule() },
    payments: { label: 'Payments', fetch: () => App.api.listPayments() },
    recurring_items: { label: 'Recurring Items', fetch: () => App.api.listRecurringItems() },
    recurring_occurrences: { label: 'Recurring Occurrences', fetch: () => App.api.listRecurringOccurrences() },
    contacts: { label: 'Contacts', fetch: () => App.api.listContacts() },
    gold_purchases: { label: 'Gold Purchases', fetch: () => App.api.listGoldPurchases() },
    accounts: { label: 'Accounts', fetch: () => App.api.listAccounts() },
    liabilities: { label: 'Liabilities', fetch: () => App.api.listLiabilities() },
    expense_projects: { label: 'Expense Projects', fetch: () => App.api.listExpenseProjects() },
    expense_transactions: { label: 'Expense Transactions', fetch: () => App.api.listExpenseTransactions() },
    expense_vendors: { label: 'Expense Vendors', fetch: () => App.api.listExpenseVendors() },
    expense_advances: { label: 'Expense Advances', fetch: () => App.api.listExpenseAdvances() },
    notes: { label: 'Notes', fetch: () => App.api.listNotes() },
    documents: { label: 'Documents', fetch: () => App.api.listDocuments() },
    goals: { label: 'Goals', fetch: () => App.api.listGoals() },
    tax_records: { label: 'Tax Records', fetch: () => App.api.listTaxRecords() },
    // Included in "Export All" only - not worth a per-view button of their
    // own (see the plan's scope decision), but genuinely part of "all my
    // data" for a full backup/export.
    audit_logs: { label: 'Audit History', fetch: () => App.api.listAuditLogs() },
    imports: { label: 'Import History', fetch: () => App.api.listImports() },
  };

  // A nested object/array field (jsonb columns, text[] tags, etc.) would
  // otherwise render as a useless "[object Object]" cell - stringify it
  // instead so the real value is at least visible and copy-pasteable.
  function cleanRows(rows) {
    return rows.map((r) => {
      const out = {};
      Object.entries(r).forEach(([k, v]) => { out[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; });
      return out;
    });
  }

  // Excel sheet names: max 31 chars, no : \ / ? * [ ]
  function safeSheetName(label) {
    return label.replace(/[:\\/?*[\]]/g, '').slice(0, 31);
  }

  async function exportSection(key) {
    const section = SECTIONS[key];
    if (!section) throw new Error('Unknown export section: ' + key);
    const rows = await section.fetch();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cleanRows(rows)), safeSheetName(section.label));
    XLSX.writeFile(wb, `${section.label.replace(/\s+/g, '_')}_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function exportFullPortfolio() {
    const wb = XLSX.utils.book_new();
    for (const section of Object.values(SECTIONS)) {
      try {
        const rows = await section.fetch();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cleanRows(rows)), safeSheetName(section.label));
      } catch (e) { /* a section this account has no rows/access for is simply skipped, not a failure */ }
    }
    XLSX.writeFile(wb, `Investment_OS_full_export_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return { SECTIONS, exportSection, exportFullPortfolio };
})();
