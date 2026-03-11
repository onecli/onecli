import { isOAuthConfigured } from "@/lib/auth/auth-mode";
import { LoginContent } from "./_components/login-content";

export default function LoginPage() {
  return <LoginContent oauthConfigured={isOAuthConfigured()} />;
}
