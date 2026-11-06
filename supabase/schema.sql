-- Caderno de Clínica — esquema do banco (Supabase / Postgres)
-- Rodar uma vez no SQL Editor do projeto.

create table if not exists public.notas (
  id           text primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  area         text not null default 'outros',
  titulo       text not null default '',
  texto        text not null default '',
  fonte        text not null default '',
  tags         text[] not null default '{}',
  origem       text not null default 'manual' check (origem in ('manual', 'claude')),
  apagado      boolean not null default false,
  criado       timestamptz not null default now(),
  atualizado   timestamptz not null default now(),
  -- carimbo do servidor: o app puxa mudanças por ele, imune a relógio errado no celular
  sincronizado timestamptz not null default now()
);

create index if not exists notas_user_sinc_idx on public.notas (user_id, sincronizado);

create or replace function public.notas_carimbo()
returns trigger language plpgsql as $$
begin
  new.sincronizado := clock_timestamp();
  return new;
end $$;

drop trigger if exists notas_carimbo on public.notas;
create trigger notas_carimbo
  before insert or update on public.notas
  for each row execute function public.notas_carimbo();

alter table public.notas enable row level security;

drop policy if exists "dono le"      on public.notas;
drop policy if exists "dono cria"    on public.notas;
drop policy if exists "dono altera"  on public.notas;
drop policy if exists "dono apaga"   on public.notas;

create policy "dono le"     on public.notas for select using (user_id = auth.uid());
create policy "dono cria"   on public.notas for insert with check (user_id = auth.uid());
create policy "dono altera" on public.notas for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "dono apaga"  on public.notas for delete using (user_id = auth.uid());
