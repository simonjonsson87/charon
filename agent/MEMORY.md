# Agent Memory

This file is read at the start of every agent session and updated during board meetings.
Keep entries concise — this file is injected into the prompt context on every session.
Long entries waste inference budget. Prefer distilled insights over verbose narratives.

---

## Capital & Financial State
_Updated by agent during board meetings._

No entries yet. First board meeting will populate this section.

---

## Experiment Log
_Agent records decisions and their outcomes here. Tool calls to `save_experiment` and `evaluate_experiment` update the DB; key learnings are summarised here._

No experiments yet.

---

## Learned Priors
_Beliefs updated through experience. These should change as experiments produce evidence._

No priors established yet. Initial priors will be set after first 30 days of operation.

Placeholder priors to be validated:
- Fee elasticity: unknown — a 0.1% fee reduction may or may not increase volume.
- Peak hours: unknown — confirmation times likely vary by UTC hour.
- Energy provider efficiency: TronSave is likely cheaper than burning at most price levels.

---

## Board Meeting Summaries
_Qualitative assessments from past board meetings. Oldest entries may be trimmed once the log grows._

No board meetings yet. Agent is newly deployed.

---

## Operational Notes
_One-line notes about the system's operational behaviour, added as discovered._

- Address pool minimum: 20 addresses. Increase if concurrent payment volume grows.
- Webhook retry: 5 attempts at 10s intervals. Persistent failures are logged but do not affect payment status.
