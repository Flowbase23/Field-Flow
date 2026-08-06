"use client";
/**
 * Popover — shadcn-style wrapper over @base-ui/react Popover (installed,
 * memory-light; no Radix). Used for the appointment detail popover.
 */
import * as Popover from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

export function PopoverRoot(props: React.ComponentProps<typeof Popover.Root>) {
  return <Popover.Root {...props} />;
}

export function PopoverTrigger(props: React.ComponentProps<typeof Popover.Trigger>) {
  return <Popover.Trigger {...props} />;
}

export function PopoverContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Popover.Popup>) {
  return (
    <Popover.Portal>
      <Popover.Positioner className="z-50 outline-none" sideOffset={6}>
        <Popover.Popup
          {...props}
          className={cn(
            "w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-background p-4 shadow-xl ring-1 ring-foreground/10 outline-none",
            className,
          )}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
