Update the Markdown PRD after a completed agent scope.

PRD path: {{prdPath}}
YAML plan path: {{planPath}}

Completed scope:
{{scopeText}}

Quality gate results:
{{gateSummary}}

Instructions:

- Edit only the Markdown PRD file.
- Mark completed relevant PRD tasks with [+].
- Leave not-started tasks as [ ] and active remaining work as [~] only when it is genuinely in progress.
- Add a concise progress note for the completed scope.
- Keep the Markdown human-readable; do not add machine-state JSON or YAML into the PRD.
- Do not edit source code or tests in this sync pass.
