terraform {
  required_version = ">= 1.15.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }

  # backend はローカル（指定なし）。チームで使うなら s3 などのリモート backend に置き換える。
}

# 認証は環境変数 CLOUDFLARE_API_TOKEN で渡す。
provider "cloudflare" {}
