// 公開的 Supabase 專案連線設定（不含任何私密金鑰；安全性由 Postgres Row Level Security 保障）
// 站長建立免費 Supabase 專案並執行 supabase/schema.sql 後，將 Project URL 與 anon public key 填入此處即全站生效。
export const CLOUD_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: ''
};
