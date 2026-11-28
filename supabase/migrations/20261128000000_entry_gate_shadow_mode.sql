-- Owner-approved default: observe the old entry model without vetoing entries.
ALTER TABLE public.position_manager_control
  ADD COLUMN IF NOT EXISTS entry_gate_mode text NOT NULL DEFAULT 'shadow'
  CHECK (entry_gate_mode IN ('shadow', 'enforce'));
COMMENT ON COLUMN public.position_manager_control.entry_gate_mode IS
  'shadow logs the entry model verdict; enforce permits its veto. Missing column defaults to shadow in the app.';
