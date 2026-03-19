import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, Loader2, ArrowLeft, Copy, Check } from "lucide-react";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resetLink, setResetLink] = useState("");
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }
      if (data.resetLink) {
        setResetLink(data.resetLink);
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(resetLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-8 w-8 text-primary" />
            <span className="text-2xl font-bold tracking-tight">Trading Agent</span>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Reset password</CardTitle>
            <CardDescription>
              Enter your email and we'll generate a reset link for you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!resetLink ? (
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                  />
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Generate reset link
                </Button>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="rounded-md bg-muted p-3 space-y-2">
                  <p className="text-xs text-muted-foreground font-medium">Your password reset link (valid 1 hour):</p>
                  <p className="text-xs break-all font-mono text-foreground">{resetLink}</p>
                </div>
                <Button variant="outline" className="w-full" onClick={copyLink}>
                  {copied ? (
                    <><Check className="mr-2 h-4 w-4 text-green-500" /> Copied</>
                  ) : (
                    <><Copy className="mr-2 h-4 w-4" /> Copy link</>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Open the link above in your browser to set a new password.
                </p>
              </div>
            )}

            <div className="text-center">
              <Link href="/login" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
