# Security

Handoff pushes text into a Claude Code session that can edit files and run commands, so anything that lets someone other than you get a note in counts as a security bug.

## Reporting a problem

Please don't open a public issue for a security bug. Use **[Report a vulnerability](https://github.com/maxvbuda/handoff/security/advisories/new)** on GitHub instead, which only the maintainer can see. Include what you did and what happened. You'll get a reply within a week.

## How Handoff keeps notes yours

- **Only your watch can send notes.** Each note is encrypted on the watch with AES-256-GCM, using a key only your watch and Mac have. The plugin drops anything that doesn't decrypt with that key before Claude sees it, so a stranger who finds the relay topic can't send instructions.
- **Pairing never sends the key in the clear.** The watch makes its own topic and key and sends them sealed with a key derived from the 8-character pairing code, which only lasts for that one pairing.
- **The relay only sees scrambled data.** ntfy.sh carries ciphertext on a random topic. Handoff runs no servers of its own.
- **Email only counts if you sent it.** `handoff mail` reads notes from your account's Sent mailbox, so a faked "From" address doesn't work.
- **No permission relay.** The watch can't approve Claude's permission prompts. Anything blocked waits for you at the computer.
- **No dependencies.** The plugin is plain Node with nothing from npm, so there's no supply chain to compromise.
- **Strict input checks.** Note IDs, chat names and folder paths from the watch are validated before they're used, and the host only opens folders inside the one you gave it.

See [PRIVACY.md](PRIVACY.md) for exactly what data goes where.
