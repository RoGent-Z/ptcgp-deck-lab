-- Pocket Lab 會員雲端儲存資料表結構與 Row Level Security (Supabase Postgres)
-- 在 Supabase SQL Editor 貼上並執行一次即可完成設定。

create table if not exists public.pocket_lab_vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vault jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.pocket_lab_vaults enable row level security;

drop policy if exists "Users manage own vault" on public.pocket_lab_vaults;
create policy "Users manage own vault"
  on public.pocket_lab_vaults
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
