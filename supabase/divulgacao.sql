-- ===============================
-- DIVULGAÇÃO QUINZENAL DO LABSTUDIO
-- Rode uma única vez no Supabase: SQL Editor -> New query -> colar -> Run.
-- Pode rodar de novo sem problema: nada é duplicado nem apagado.
-- ===============================

-- Quem já usou o estúdio (recebe a divulgação).
alter table public.usuarios
  add column if not exists ja_usou_estudio boolean not null default false;

-- Quem aceita receber a divulgação. Vira false quando a pessoa responde SAIR.
alter table public.usuarios
  add column if not exists aceita_divulgacao boolean not null default true;

-- Último envio de divulgação para a pessoa.
alter table public.usuarios
  add column if not exists ultima_divulgacao_em timestamptz;

-- Histórico de envios: impede mandar duas vezes no mesmo ciclo (dia 1 ou dia 15).
create table if not exists public.divulgacao_envios (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  ciclo date not null,
  status text not null check (status in ('enviado', 'erro')),
  erro text,
  mensagem_id text,
  enviado_em timestamptz not null default now(),
  unique (usuario_id, ciclo)
);

-- Usado pelo webhook da Meta para marcar falhas de entrega.
create index if not exists divulgacao_envios_mensagem_id_idx
  on public.divulgacao_envios (mensagem_id);

-- Só o servidor (service role) grava e lê o histórico.
alter table public.divulgacao_envios enable row level security;

-- Marca automaticamente quem já tem agendamento.
-- Compara os 8 últimos dígitos do telefone para ignorar +55, DDD e nono dígito.
update public.usuarios u
set ja_usou_estudio = true
where ja_usou_estudio = false
  and exists (
    select 1
    from public.agendamentos a
    where length(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g')) >= 8
      and right(regexp_replace(a.telefone, '\D', '', 'g'), 8)
        = right(regexp_replace(coalesce(u.telefone, ''), '\D', '', 'g'), 8)
  );

-- Conferência: quantas pessoas vão receber.
select count(*) as vao_receber
from public.usuarios
where ja_usou_estudio = true
  and aceita_divulgacao = true
  and coalesce(lower(status), 'ativo') <> 'bloqueado';
