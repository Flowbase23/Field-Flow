"use client";
/**
 * Dialog — shadcn-style wrapper over @base-ui/react Dialog (installed,
 * memory-light; no Radix). Used by the appointment create/edit form.
 */
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";

export function DialogRoot(props: React.ComponentProps<typeof Dialog.Root>) {
  return <Dialog.Root {...props} />;
}

export function DialogTrigger(props: React.ComponentProps<typeof Dialog.Trigger>) {
  return <Dialog.Trigger {...props} />;
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Dialog.Popup>) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
      <Dialog.Popup
        {...props}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-background p-6 shadow-2xl ring-1 ring-foreground/10 outline-none",
          className,
        )}
      >
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title {...props} className={cn("text-lg font-semibold tracking-tight", className)} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description {...props} className={cn("mt-1 text-sm text-muted-foreground", className)} />;
}

export function DialogClose(props: React.ComponentProps<typeof Dialog.Close>) {
  return <Dialog.Close {...props} />;
}
