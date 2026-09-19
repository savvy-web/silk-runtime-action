---
"@savvy-web/silk-runtime-action": patch
---

## CI

* Added a `node-npm-12` fixture (Node 26.9.0 + npm 12.0.2) and `npm12` matrix rows in `test.yml`, verifying npm 12 provisioning end to end across all three runners

## Dependencies

Adopts the kit release that adds npm 12 support (closes #396).

| Dependency                    | Type       | Action  | From    | To      |
| :----------------------------- | :--------- | :------ | :------ | :------ |
| @effected/pnpm-plugin-effect    | config     | updated | 0.8.14  | 0.8.15  |
| @effected/github-actions       | dependency | updated | 0.13.3  | 0.13.4  |
| @effected/npm                  | dependency | updated | 0.14.1  | 0.14.2  |
