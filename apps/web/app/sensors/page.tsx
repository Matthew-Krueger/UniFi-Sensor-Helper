import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function SensorsPage() {
  // TODO: fetch discovered sensors from /api/sensors (which itself queries
  // the Protect API — see SPEC.md section 8/12). Never hardcode a sensor
  // here; discovery-driven only.
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sensors</h1>
        <Button variant="outline" size="sm">
          Refresh
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>No sensors discovered yet</CardTitle>
          <CardDescription>Connect a Protect console and click Refresh to discover sensors.</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
