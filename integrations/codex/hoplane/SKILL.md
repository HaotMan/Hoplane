---
name: hoplane
description: Use policy-controlled SSH hosts through the Hoplane MCP tools. Trigger when the user asks to inspect, test, operate, deploy to, upload to, download from, or troubleshoot a remote server managed by Hoplane, or when Hoplane MCP tools are missing or fail to initialize.
---

# Hoplane

Use Hoplane's MCP tools for every remote operation so credentials remain hidden and policy and audit controls remain active.

## Workflow

1. Check whether the Hoplane `list_hosts` MCP tool is available.
2. If it is unavailable, run `scripts/diagnose` on macOS/Linux or `scripts/diagnose.cmd` on Windows from this skill directory. Report the returned checks and ask the user to restart the current AI client when the configuration was just installed. Do not replace this check with direct HTTP requests to localhost.
3. Call `list_hosts` before operating unless the user already supplied an unambiguous host ID from the current result.
4. Match the requested host by ID or exact name. Ask before choosing between ambiguous hosts.
5. Use `test_host` when connectivity is unknown. If a host key is new or changed, direct the user to confirm it in the Hoplane App; never accept it yourself.
6. Use `execute_command`, `upload_file`, or `download_file` as requested. Preserve the user's command and paths; do not broaden an operation after a policy denial.
7. Return stdout, stderr, exit code, duration, or transfer size concisely. Explain policy denials using the returned reason code.

## Guardrails

- Never request, read, print, or copy SSH passwords, private keys, passphrases, Core tokens, or vault contents.
- Never bypass Hoplane with `ssh`, `scp`, `sftp`, raw Core HTTP calls, or a separately written request script.
- Never modify Hoplane policy, AI-access settings, credentials, or trusted host keys on the user's behalf.
- Treat command execution and file transfer as remote side effects. Confirm destructive or materially ambiguous actions before calling a tool.
- If Hoplane reports that the vault is locked, ask the user to unlock it in the App.
