# Claude Multi-Account Switcher — Design

Date: 2026-07-30
Status: Approved (design) — UI revised 2026-07-30 to a dropdown in the existing Settings section
Scope: macOS only (v1)

## Problem

Claude Code CLI keeps a single login. Logging into a second account overwrites
the first, and there is no way back without re-authenticating. Users want to save
several logged-in accounts, pick one to use, and only re-login when a token breaks.

## Root cause (verified on this machine)

- The extension never manages Claude auth. It spawns `claude` from PATH and
  inherits ambient auth from `~/.claude` (all paths hardcoded via `os.homedir()`).
- On macOS, login is stored in the **macOS Keychain**, not a file:
  - `service = "Claude Code-credentials"`, `account = <OS username>` (e.g. `khainguyen`).
  - There is **no** `~/.claude/.credentials.json` file.
- This Keychain slot is a single fixed location keyed by OS user, so every login
  overwrites it — the cause of the "đè" behavior.
- `CLAUDE_CONFIG_DIR` forks the **entire** config dir (agents, skills, CLAUDE.md,
  history, MCP, settings), and does **not** re-key the Keychain slot. It cannot
  isolate only the login. Rejected.

## Chosen approach — "Approach A" (Keychain swap)

One shared `~/.claude` for everything. Only the **login blob in the canonical
Keychain slot** is swapped when switching accounts. Nothing else changes.

Consequences (accepted by user):
- **Global scope**: switching changes the login for *all* Claude Code on the
  machine (including terminals outside the extension), because the Keychain slot
  is shared. This matches the goal "share everything, only login differs".
- Metadata lives in the extension `globalStorage`, which is shared across all
  workspaces/windows, so any repo sees the same accounts and active login —
  automatically synced.
- A `claude` session already running keeps its old login until it is restarted.

## Data & storage

### Secrets — stored in Keychain, never in plaintext files
Each saved account is its own Keychain item under our own service:
- `security add-generic-password -U -s "ClaudeSteps-accounts" -a "<name>" -w <blob>`

The canonical Claude slot read/written for switching:
- Read:  `security find-generic-password -s "Claude Code-credentials" -a "<osuser>" -w`
- Write: `security add-generic-password -U -s "Claude Code-credentials" -a "<osuser>" -w <blob>`

`<osuser>` is resolved once via `os.userInfo().username`.

### Metadata — `globalStorage`, no secrets
A small JSON persisted via the extension context `globalState` (or a file in
`context.globalStorageUri`):

```jsonc
{
  "accounts": [
    {
      "name": "ba@itrvn.com",        // identifier + Keychain item account key
      "email": "ba@itrvn.com",       // from ~/.claude.json oauthAccount
      "displayName": "…",            // optional label extras
      "organizationName": "ITR",     // optional
      "fingerprint": "<sha256 of blob>",
      "savedAt": "<iso>"
    }
  ]
}
```

### Label comes from `~/.claude.json`, not the token
The token blob has no email. Claude Code writes the signed-in account into the
**non-secret** config file `~/.claude.json` under `oauthAccount`
(`emailAddress`, `displayName`, `organizationName`). At **save time** this file
reflects the currently active login — the same account whose blob we are saving —
so the manager reads `oauthAccount.emailAddress` (+ displayName/org) there and
stores it as the account's label. No parsing of the credential is needed.

`~/.claude.json` is a single shared file that always tracks the *active* account,
so it is only trustworthy as a label source **at the moment of saving**. Switching
does not rewrite it; Claude reconciles `oauthAccount` from the profile API on its
next run. A brief stale email in that file after a switch is cosmetic and ignored
(our labels live in our own metadata).

"Active" is not stored; it is **derived** by hashing the current canonical blob
and matching it against `fingerprint`. This stays correct even if login changes
outside the extension.

### Metadata is the authoritative account list
The `security` CLI cannot cleanly enumerate all items for a service, so the
account **list** comes from metadata, not from scanning the Keychain. Keychain
items are always looked up by known name.

A `main` item was captured manually before the feature shipped (pure login
backup, no metadata). Once the feature ships, the user clicks "Save current login
as account…" while `main` is the active login; it is saved as a first-class
account keyed by its email (`ba@itrvn.com`) with full metadata. The leftover
`main` Keychain item is a harmless orphan the user may delete. No Keychain
enumeration or auto-import is attempted.

## Components

### `accountManager.ts` (new, `packages/extension/src`)
Owns all Keychain interaction and metadata. Pure logic; `security` calls go
through an injected `exec` function so it is unit-testable without a real Keychain.

Public API:
- `saveCurrentAsAccount(name?: string): Promise<void>`
  Read canonical blob → refuse if empty/invalid → read `oauthAccount` from
  `~/.claude.json` for `email`/`displayName`/`organizationName` → default `name`
  to the email when not supplied → store blob as `ClaudeSteps-accounts` item keyed
  by `name` → upsert metadata with the label fields, `fingerprint = sha256(blob)`,
  and `savedAt`. This is the "capture-on-login" primitive (also used after
  re-login; the same name overwrites to refresh its token). If `~/.claude.json`
  has no `oauthAccount`, fall back to a user-supplied name and empty label extras.
- `switchTo(name: string): Promise<void>`
  Read saved item → write blob into canonical slot. Throws if the saved item is
  missing.
- `listAccounts(): Promise<{ name: string; savedAt: string; active: boolean }[]>`
  Read canonical blob, compute fingerprint, mark the matching account active.
  If no account matches (login done outside), all are inactive.
- `removeAccount(name: string): Promise<void>`
  Delete the `ClaudeSteps-accounts` Keychain item and its metadata entry.
- `isSupported(): boolean` — true only on macOS with the `security` binary present.

Fingerprint: `sha256` hex of the raw blob string (Node `crypto`).

### Sidebar UI (`sidebarHtml.ts`, `sidebarProvider.ts`, `sidebarActions.ts`)
Follows the existing message-passing pattern (`onDidReceiveMessage` switch on
`message.type` → `SidebarActions` method → re-render), and reuses the existing
**Settings** section (`settings-panel`) and its `setting-row` + `<select>`
styling (same shape as the `ai-style-select` / `review-kit-select` rows).

A new `setting-row` "Claude Account" inside the Settings section:
- A `<select id="account-select">` listing one `<option>` per saved account,
  value = account `name` (its email), text = email. The **active** account
  (derived by fingerprint match against the current canonical blob) is the
  selected option. If no account matches (login changed outside the extension),
  a leading disabled `— (unknown / external login) —` option is selected.
- Two small buttons next to the select: **`＋ Save`** (save current login as an
  account) and **`🗑 Remove`** (remove the currently selected account).
- Changing the select fires a `switch`. Selecting the disabled "unknown" option
  is a no-op.
- The whole row is hidden (or shown disabled with a one-line note) when
  `isSupported()` is false.
- No "Re-login" control in v1 (dropped per revision). Re-login is done by the
  user in a normal terminal, then re-saving under the same email refreshes the
  token — the `＋ Save` button covers it.

New message types handled in `sidebarProvider.ts` and delegated to `SidebarActions`:
- `accountSaveCurrent` → `saveCurrentAsAccount` (name auto-derived from
  `~/.claude.json` `oauthAccount.emailAddress`; only prompts for a name when
  `oauthAccount` is absent) → refresh
- `accountSwitch` (name, from the select value) → `switchTo` → refresh
- `accountRemove` (name = current select value) → confirm → `removeAccount` → refresh
- The account list + active flag are included whenever the sidebar refreshes;
  `listAccounts()` runs on `resolveWebviewView`, on `refresh`, and on webview view
  focus so a second window picks up changes.

## Error handling

- **Not macOS / no `security`**: `isSupported()` false → feature hidden; no crash.
- **ACL prompt**: the first `security ... -w` read of the Claude-created slot may
  raise a macOS "allow access" dialog. Expected; user clicks Allow. If the read
  fails/returns empty, surface a clear message with guidance instead of failing
  silently.
- **Empty/invalid blob on save**: refuse and message the user (do not store).
- **Stale/missing email on save (new-account timing)**: Claude writes
  `oauthAccount` to `~/.claude.json` only after the post-`/login` profile fetch.
  If a save runs before that, the email may be stale or absent. Mitigation: when
  `oauthAccount` is missing, fall back to an input box for a manual name; guidance
  tells the user to click `＋ Save` *after* the new session has initialized.
- **Switch target missing**: throw a user-visible error; keep current login intact.
- **Switch while a `claude` terminal is running**: toast warning that running
  sessions keep the old login until restarted.

## Testing

Unit tests for `accountManager` with a mock `exec` capturing `security` argv and
returning canned blobs:
- save stores an item + upserts metadata with correct fingerprint
- save refuses empty/invalid blob
- switch writes the saved blob to the canonical slot
- switch throws when the saved item is missing
- list marks exactly the fingerprint-matching account active; none when no match
- remove deletes item + metadata entry
- `isSupported()` false path returns early (no `security` calls)

No real Keychain is touched in tests.

## Out of scope (v1)

- Linux/Windows (file-based `.credentials.json`) — later.
- Per-extension credential isolation (would require forcing file-based creds).
- Auto-detecting auth failures from `claude` output (manual re-login chosen).
- Reading/showing the account email from the token.
