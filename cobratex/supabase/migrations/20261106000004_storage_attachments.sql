-- 20261106000004_storage_attachments.sql
-- Attachments live in a PRIVATE Supabase Storage bucket (5 MB, images + PDF).
-- Design decision (merged build): ALL reads/writes go through the Express API (service_role key on the server),
-- which validates permissions, company isolation, license limits and file magic bytes (attachmentService.ts).
-- Therefore NO storage.objects policies and NO direct INSERT/DELETE grants on public.attachments are created:
-- the browser can never touch the bucket directly. (A direct-upload variant bypasses the server-side content checks.)
-- Object path written by the API: <company_id>/<entity_type>/<attachment_id>.<ext>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 5242880,
        array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Same column as backend migration 0070 (idempotent): new rows carry a storage_path instead of BYTEA bytes.
alter table public.attachments add column if not exists storage_path text;
alter table public.attachments alter column file_data drop not null;
create unique index if not exists uq_attachments_storage_path on public.attachments(storage_path) where storage_path is not null;

-- AFTER running `npm run attachments:to-storage` (backend) and verifying downloads:
--   alter table public.attachments drop column file_data;   then VACUUM FULL public.attachments;
