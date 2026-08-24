-- ============================================================================
-- 011: Supabase Storage bucket + RLS for documents (spec Section 29)
-- ============================================================================
-- Path convention: {user_id}/{deal_id-or-'general'}/{filename}. storage.
-- objects already has RLS enabled by default on Supabase, so only policies
-- are added here (no ALTER TABLE ... ENABLE ROW LEVEL SECURITY needed/
-- permitted on that system table).
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "select own documents in storage" on storage.objects;
create policy "select own documents in storage"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);

drop policy if exists "insert own documents in storage" on storage.objects;
create policy "insert own documents in storage"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);

drop policy if exists "update own documents in storage" on storage.objects;
create policy "update own documents in storage"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);

drop policy if exists "delete own documents in storage" on storage.objects;
create policy "delete own documents in storage"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'documents' and (select auth.uid())::text = (storage.foldername(name))[1]);
