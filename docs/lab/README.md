# Lab scripts

These are the throwaway scripts behind the table "What was tested for this guide" in [many-companies.md](../many-companies.md). They were run once, on 12 November 2026, against copies of this project. They are a record of what was proven, not part of the product: step 2 of the build order turns them into proper commands.

| File | What it shows |
| --- | --- |
| [one-company.network.json](one-company.network.json) | The `network.json` of a company launching alone: one company, one home workspace |
| [three-companies.network.json](three-companies.network.json) | The demo's three companies under other names and ports, plus a workspace only Aster is on |
| [who-needs-whom.ts](who-needs-whom.ts) | Stops other companies' nodes and checks which workspaces still take messages |
| [connect-two-companies.mjs](connect-two-companies.mjs) | Connects two companies that were set up separately: cards, first block, join, approve, talk |
| [talk.ts](talk.ts) | One person does one thing on one channel, through their own company's peer |

## Running them again

1. Copy this project twice, to two folders side by side called `lab` and `dune`. Leave out `node_modules`, `.generated` and `dist`, then run `npm install` in each.
2. Replace `lab/network.json` with `three-companies.network.json` and `dune/network.json` with `one-company.network.json`.
3. Run `npm run net:up` in each folder. Both have their own names and ports, so they do not disturb the demo.
4. Copy `who-needs-whom.ts` to `lab/server/` and run it there with `npx tsx server/who-needs-whom.ts`.
5. Put `connect-two-companies.mjs` and `talk.ts` (renamed `pairtalk.ts`) in the folder that holds `lab` and `dune`, and run `node connect-two-companies.mjs`.
6. Run `npm run net:down` in `dune`, then in `lab`.

Both `network.json` files set `ports.cluster`. Without it the two companies' orderers do not agree on a leader: see "One trap" in the guide.
