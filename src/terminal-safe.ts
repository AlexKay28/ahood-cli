// Control characters are replaced with a space rather than deleted so that
// stripping can't silently glue two tokens into one misleading word.
//
// Newlines (\x0a) and carriage returns (\x0d) are inside this range and are
// deliberately flattened too (ahood-cli#127): a forged prompt line
// ("...\n\nEnter your token:") needs no escape sequence at all, just a
// newline, so preserving them would leave the spoofing half of the threat
// model open while closing the escape half. The readability cost is small
// because callers bound what reaches here to a few lines' worth of text, not
// a stack trace.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

// Text that reaches the terminal but originates outside this CLI -- a manifest
// field from a third-party-published archive, an error string forwarded by the
// API -- can smuggle a terminal control sequence (cursor movement, line-clear)
// that repaints what the user sees. That matters most in `add`, which prints
// such text immediately before a masked secret prompt: the exact moment a
// repaint can convince a user to type a credential into an attacker's message.
// This strips C0/C1 control characters (including ESC, \x1b) and caps length so
// a single field can't also flood the terminal.
//
// Takes `unknown` rather than `string` because a caller's "string" may be a
// declared type over an unchecked cast of downloaded JSON, not a guarantee:
// calling .replace() directly on a `registry_type: 123` would turn a
// diagnosable message into the raw TypeError ahood-cli#121 removed from that
// same path (ahood-cli#122).
export function sanitizeForTerminal(text: unknown, maxLength = 200): string {
  return String(text).replace(CONTROL_CHARACTERS, " ").slice(0, maxLength);
}

// Same C0/C1 range as CONTROL_CHARACTERS above, minus the three characters
// that carry a document's layout rather than a terminal instruction: tab
// (\x09), line feed (\x0a) and carriage return (\x0d).
const CONTROL_CHARACTERS_EXCEPT_LAYOUT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

// The document-shaped sibling of sanitizeForTerminal, for the one caller that
// prints a whole publisher-authored file to a human's terminal
// (`ahood skill read`, ahood-cli#133) rather than a field interpolated into a
// CLI-authored message. Two of sanitizeForTerminal's decisions invert at that
// size, which is why this is a separate function rather than an extra
// argument on that one -- a flag that flips half of a function's documented
// behaviour is harder to reason about than two functions with two rationales:
//
//   - Newlines are preserved. #127 flattens them because a forged prompt line
//     ("...\n\nEnter your token:") needs no escape sequence at all, and that
//     rationale explicitly rests on callers bounding input "to a few lines'
//     worth of text". A markdown document is not that: flattening it yields
//     one unreadable line, destroying the command. The spoofing risk it trades
//     away is also much weaker here -- `read` prints and exits without ever
//     prompting, and a user who typed `ahood skill read` has already been told
//     they are looking at someone else's untrusted prose.
//
//   - There is no length cap. sanitizeForTerminal's 200 exists so one field
//     can't flood the terminal; capping a document the user explicitly asked
//     to read is its own failure mode, and a hostile one: a publisher could
//     simply push the part worth hiding past the cap and let the CLI truncate
//     it away, turning a safety measure into a concealment primitive. Once the
//     escapes are gone the residue is plain text that scrolls -- which the
//     terminal's scrollback, a pager, or Ctrl-C already handles, and which
//     cannot repaint, retitle, or hide anything.
//
// Takes `unknown` for the same reason sanitizeForTerminal does (ahood-cli#122).
export function sanitizeDocumentForTerminal(text: unknown): string {
  return String(text).replace(CONTROL_CHARACTERS_EXCEPT_LAYOUT, " ");
}
