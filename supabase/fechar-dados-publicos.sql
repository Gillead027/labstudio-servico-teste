-- ===============================
-- FECHAR DADOS PESSOAIS PARA A CHAVE PÚBLICA
-- usuarios e agendamentos passam a ser acessíveis só por admins logados no painel.
-- O servidor (site, cadastro online e bot) usa a chave secreta e não é afetado.
-- Rode no Supabase: SQL Editor -> New query -> colar -> Run.
-- ===============================

-- 1. Cópia das regras atuais, para poder voltar atrás (ver o final do arquivo).
create table if not exists public.backup_policies_20261001 as
select * from pg_policies
where schemaname = 'public' and tablename in ('usuarios', 'agendamentos');

alter table public.backup_policies_20261001 enable row level security;

-- 2. Função que diz se quem está logado é admin ativo.
-- security definer: consulta admin_users sem depender das regras dessa tabela.
create or replace function public.eh_admin_labstudio()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid() and a.ativo and a.role = 'admin'
  );
$$;

revoke all on function public.eh_admin_labstudio() from public;
grant execute on function public.eh_admin_labstudio() to authenticated;

-- 3. Remove as regras atuais de usuarios e agendamentos.
do $$
declare
  regra record;
begin
  for regra in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in ('usuarios', 'agendamentos')
  loop
    execute format('drop policy %I on public.%I', regra.policyname, regra.tablename);
  end loop;
end $$;

-- 4. Garante RLS ligado e cria a regra única: só admin logado.
alter table public.usuarios enable row level security;
alter table public.agendamentos enable row level security;

create policy "somente admins - usuarios" on public.usuarios
  for all to authenticated
  using (public.eh_admin_labstudio())
  with check (public.eh_admin_labstudio());

create policy "somente admins - agendamentos" on public.agendamentos
  for all to authenticated
  using (public.eh_admin_labstudio())
  with check (public.eh_admin_labstudio());

-- 5. Histórico da divulgação usa a mesma checagem.
drop policy if exists "admins leem envios da divulgacao" on public.divulgacao_envios;

create policy "admins leem envios da divulgacao" on public.divulgacao_envios
  for select to authenticated
  using (public.eh_admin_labstudio());

-- Conferência: deve listar só as regras novas.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('usuarios', 'agendamentos', 'divulgacao_envios');

-- ===============================
-- PARA VOLTAR ATRÁS (só se o painel parar de funcionar):
-- veja as regras antigas com:
--   select tablename, policyname, cmd, roles, qual, with_check from public.backup_policies_20261001;
-- e me mande o resultado que eu monto o SQL de restauração.
-- ===============================
