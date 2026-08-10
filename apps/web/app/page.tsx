import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardPage() {
  // TODO: fetch from /api/state and render live latch cards (idle/armed/fired),
  // polled every few seconds per SPEC.md section 5. Empty state for now —
  // no latches exist until API discovery + the Latches page are built.
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <Card>
        <CardHeader>
          <CardTitle>No latches configured yet</CardTitle>
          <CardDescription>Add sensors and latches to see live state here.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The latch engine is running independently of this page — this is only a window into its state.
        </CardContent>
      </Card>
    </div>
  );
}
