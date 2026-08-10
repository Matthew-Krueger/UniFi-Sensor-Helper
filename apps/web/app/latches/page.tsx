import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LatchesPage() {
  // TODO: CRUD UI over /api/latches — sensor picker (from discovered
  // sensors only), metric, direction, arm/clear thresholds, duration,
  // webhook + resolvedWebhook config. Webhook URLs must render through
  // maskSecret in this UI, never in full — see CLAUDE.md.
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Latches</h1>
        <Button size="sm" disabled>
          New Latch
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>No latches yet</CardTitle>
          <CardDescription>Add a sensor first, then create a latch against one of its metrics.</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
