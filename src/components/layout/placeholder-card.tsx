import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Honest placeholder used by not-yet-built feature pages. */
export function PlaceholderCard({ title, target }: { title: string; target: string }) {
  return (
    <Card className="mx-auto mt-12 w-full max-w-xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          This area is scaffolded but not built yet — scheduled for {target}. The route,
          authorization gate, and data model are already in place.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        No data is shown here because no live database exists yet.
      </CardContent>
    </Card>
  );
}
