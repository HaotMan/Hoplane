const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/(-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----)[\s\S]*?(-----END (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----)/giu, "$1\n[REDACTED]\n$2"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]"],
  [/\b(password|passwd|passphrase|token|secret|api[_-]?key)\s*[=:]\s*([^\s&;]+)/giu, "$1=[REDACTED]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_AWS_KEY]"]
];

export function redact(value: string, maxLength = 4096): string {
  let result = value;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) result = result.replace(pattern, replacement);
  if (result.length > maxLength) result = `${result.slice(0, maxLength)}…[truncated]`;
  return result;
}
