export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} が未設定です。mise.local.toml に設定してください。`);
    process.exit(1);
  }
  return v;
}
