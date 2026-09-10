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
