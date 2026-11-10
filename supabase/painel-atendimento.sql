-- ===============================
-- LEMBRETES DE AGENDAMENTO (painel de atendimento)
-- Rode uma única vez no Supabase: SQL Editor -> New query -> colar -> Run.
-- Pode rodar de novo sem problema: nada é duplicado nem apagado.
-- ===============================

-- Quando o lembrete do horário foi enviado ao jovem (vazio = ainda não enviado).
alter table public.agendamentos
  add column if not exists lembrete_enviado_em timestamptz;

-- Agendamentos que já passaram não recebem lembrete.
update public.agendamentos
set lembrete_enviado_em = now()
where lembrete_enviado_em is null
  and data::date < (now() at time zone 'America/Sao_Paulo')::date;

-- Conferência: lembretes que ainda vão sair.
select count(*) as lembretes_pendentes
from public.agendamentos
where status = 'agendado'
  and lembrete_enviado_em is null;
