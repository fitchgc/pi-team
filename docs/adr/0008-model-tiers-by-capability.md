# ADR 0008: Default role models tiered by capability (Llmapi)

- Status: accepted (john, 2026-11-24 — "按能力高低自己配置")
- Date: 2026-11-24
- Supersedes: the reviewer row of ADR 0006 (reviewer was sol)

## Context

The Llmapi key exposes 13 models, all OpenAI-family. The GPT-6 line has four
capability tiers, confirmed against public pricing comparisons (2026-11-24):

| Tier | Newest model on the key | API price / 1M tokens (in / out) | Position |
|---|---|---|---|
| Luna | gpt-6-luna | $0.10 / $0.50 | Entry: fast, high-volume, short focused tasks |
| Terra | gpt-6.1-terra | $1 / $5 | Balanced middle: writing, visual reasoning, computer use |
| Sol | gpt-6.2-sol | $2 / $10 | Everyday flagship, near-Astra on coding at 1/4 the price |
| Astra | gpt-6.2-astra | $8 / $40 | Flagship: the most demanding reasoning and coding |

Notes: the four tiers span three generations (6.2 Astra/Sol, 6.1 Terra,
6 Luna). Luna at $0.10 is 1% of Astra's $10 (GPT-6 Astra) — consistent with
the earlier finding that Luna is ~1% of Astra's list price. Within a tier,
the newest generation is the default. All four tiers share ~1.05M context
and 128K max output.

## Decision

Default model per role, by how much capability the job needs:

| Role | Model | Tier | Why |
|---|---|---|---|
| dispatcher | llmapi/gpt-6.2-sol | Sol | Coordination + verdict judging; runs constantly, flagship is waste |
| planner | llmapi/gpt-6.2-sol | Sol | Spec writing + decomposition; structured judgment, not open-ended coding |
| coder | llmapi/gpt-6.2-astra | Astra | Implementation is the hardest job in the pipeline |
| architect | llmapi/gpt-6.2-astra | Astra | Design decisions constrain every parallel coder |
| qa | llmapi/gpt-6.2-astra | Astra | Verification + failure diagnosis must be at least as strong as the coder |
| reviewer | llmapi/gpt-6.1-terra | Terra | Checklist review against conventions; half Sol's price, no open-ended work |
| security-auditor | llmapi/gpt-6.2-astra | Astra | Adversarial analysis; a missed finding costs more than the model |

No role uses Luna: every role's output is long-form and hard to check, the
opposite of what Luna is built for (short, focused, easily-checked calls).

## Consequences

- Only the reviewer default changed (sol → 6.1-terra); the other five role
  defaults and the dispatcher model are unchanged.
- A project can still override any role in `.pi/team.json` (agy models included).
- If Llmapi adds a newer Terra (e.g. 6.2-terra), the reviewer default moves to
  it; the tier mapping, not the exact model id, is the durable decision.
