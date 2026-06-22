# DCF — Data Classification Format

**Module:** [`src/convergence_io/dcf.py`](../../src/convergence_io/dcf.py) · **Principle:** P1 (Data Classification) · **Feeds:** CCF

**Status:** Built and unit-tested. This is the Python reference version; the live chat app (JavaScript) doesn't call it directly yet — see the [README](README.md#status-honest).

## In one sentence

DCF puts a **label on every piece of data** — *"this is a dream," "this is the user's email"* — and makes sure that label **travels with the data even after it's been changed or summarized**. So before anything happens to a piece of data, the system can just check its label instead of re-reading the whole thing.

## The everyday version

Think of a **food allergy warning**. A bag of peanuts says "contains peanuts." Blend those peanuts into a smoothie and the smoothie *still* contains peanuts — the warning has to follow the food, even though the food now looks completely different.

Data works the same way. A user's private dream is labeled **private**. Ask the system to summarize that dream, and the summary is **still private** — the label rides along on its own. (The project's shorthand for this is *"a summary of a FERPA record is still a FERPA record"* — FERPA being a strict privacy law. The point is that the protection sticks to the data, no matter how it's reshaped.)

That "the label follows the data" behavior is called **propagation**, and it's the whole job of DCF.

## What gets labeled

These are the labels the Dream Journal actually uses. The last column is the interesting one: whether a label survives when the data gets reworked into something new.

| Label | What it covers | How sensitive | Follows the data? |
|---|---|---|---|
| `dream_content` | the user's actual dreams | standard | yes |
| `user_identity` | name, email | sensitive | yes — kept at most 365 days |
| `symbolic_data` | symbols, lore, characters the user invents | standard | yes |
| `emotion_tag` | mood tags on an entry | standard | yes |
| `csf_archive` | an archived bundle of entries | standard | yes |
| `agent_response` | the AI's reply | standard | no |
| `system_metadata` | timestamps, which agent answered, session state | public | no |

So if you summarize a dream, the summary inherits `dream_content` and stays protected. But a raw timestamp (`system_metadata`) doesn't carry forward — anything built from it starts with a clean slate.

## What's in the toolkit

Two building blocks. Developer names are in `code`; the plain meaning sits right next to each.

**The label rulebook — `ClassificationLabel`.** Defines one kind of label: its name, how sensitive it is (`public` → `standard` → `sensitive` → `restricted`), whether it follows the data, how long you're allowed to keep it (retention), and which region's rules apply (local / US / EU / global).

**The stickers on one piece of data — `DataClassification`.** The set of labels actually attached to a specific thing. It can:

- **`add_label` / `has_label`** — put a label on, or check whether one is there.
- **`has_any_sensitive`** — a quick "is any of this sensitive?" check.
- **`is_retained`** — "are we still allowed to keep this, or has it aged out?"
- **`derive`** — *the important one.* When you make new data out of old data (a summary, a translation), this builds the new set of stickers and carries over only the labels that are meant to follow. This is propagation in action.
- **`to_dict`** — turn it into plain data for saving or logging.

## Where it sits in the safety stack

DCF goes **first**. It's the front door:

1. **DCF** — label the data. *(you are here)*
2. **[NAP](NAP.md)** — a hard "no": some actions are simply forbidden, and nothing else can override that.
3. **[CCF](CCF.md)** — check whether the agent is actually allowed to act on *data of this kind*.

The rule of thumb: **figure out what you're holding before you decide what you're allowed to do with it.**

## Status & gaps

- **Working and tested.** Clean, well-defined data structures, covered by the convergence-io test suite ([`tests/test_convergence_io.py`](../../tests/test_convergence_io.py)).
- **The standard labels ship with the code.** `dcf.py` includes a ready-made set called `DREAM_LABELS` — the seven labels above, with their sensitivity and retention already filled in.
- **But that rulebook isn't applied automatically.** `is_retained` and `derive` don't reach for `DREAM_LABELS` on their own — you have to hand them the label definitions each time you call them. So the policy exists; it just isn't auto-wired in yet.
