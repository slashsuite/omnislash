# Personas

Five made-up readers who judge OmniSlash's text: the product page and its docs, the command help and output, and the messages the tool writes to a person. They are invented. A judgement from one is a guess at what that kind of reader would say, not a real person's view, so treat it as a prompt for a human reader, not a verdict.

The file is `personas.json`. Its shape matches the other repos' persona files, so the same tools can read them. Edit the JSON, not this page.

## Who uses OmniSlash

| Who | Covered by | Gap |
| --- | --- | --- |
| A solo developer running several coding agents at once | Mira | Nobody who runs agents on a machine they do not own, such as a shared server. |
| A developer who joins a project part time | Tomasz | Nobody who joins a team full time for a long stretch. |
| A team lead weighing a move from another tracker | Dana | Nobody from a team of more than about ten people, or one with a compliance review. |
| A careful evaluator who self-hosts | Sipho | Nobody who wants a hosted version and will never run it themselves. |
| Expert lens | The plain-language technical writer | No accessibility specialist yet. |

The gaps are prompts, not personas. Add one only when a review would be judged unfairly without that reader.

## Focus keys

Each persona says what it looks for in each kind of text:

- `page`: the product page and the docs.
- `cli`: the command help, the output and the errors.
- `message`: text an agent or the tool writes to a person, such as a status line or a notice.

A persona that is not a user of a key says so in its focus for that key.

## Model

Every persona runs on `opus` for now. Change `model` per persona when other readers are available.

## Groups

`groups` names each group a persona belongs to. `models` lists the models the personas are set up to use.
