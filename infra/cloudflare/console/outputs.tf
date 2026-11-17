output "console_aud" {
  description = "AUD。設定ファイルの AWSBRIDGE_CONSOLE_AUD_FILE の形（teams と 1 つの entry）。`terraform output -json console_aud` をそのファイルに保存する（AUD は端末に出さない）"
  sensitive   = true
  value = {
    teams = { for k, a in cloudflare_zero_trust_access_application.team : k => a.aud }
    entry = cloudflare_zero_trust_access_application.entry.aud
  }
}
