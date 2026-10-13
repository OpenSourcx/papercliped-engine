import { Link, useLocation } from "react-router-dom";
import { SearchX } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { Button, Card, EmptyState, PageFrame } from "../ui/primitives.tsx";

/** An address that leads nowhere. Says so plainly (never blames the engine for a typo) and offers the way back. */
export function NotFound({ title = "We couldn't find that page", body }: { title?: string; body?: string }) {
  const { setup } = useEngine();
  const { pathname } = useLocation();
  const device = setup?.deviceName ?? "pve";
  return (
    <PageFrame width="3xl">
      <Card className="mt-6">
        <EmptyState
          icon={<SearchX className="h-5 w-5" />}
          title={title}
          body={body ?? `Nothing lives at ${pathname}. Check the address, or go back to the start.`}
          action={<Link to={`/${device}/home`}><Button variant="primary">Go to Home</Button></Link>}
        />
      </Card>
    </PageFrame>
  );
}
