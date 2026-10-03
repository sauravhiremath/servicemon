import { Group, Panel, Separator } from 'react-resizable-panels';
import { cn } from '../lib/utils.js';

function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return <Group data-slot="resizable-panel-group" className={cn('flex h-full w-full data-[orientation=vertical]:flex-col', className)} {...props} />;
}

function ResizablePanel({ ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({ withHandle, className, ...props }: React.ComponentProps<typeof Separator> & { withHandle?: boolean }) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center bg-border outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 focus-visible:ring-2 focus-visible:ring-ring aria-[orientation=horizontal]:h-2 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0',
        className,
      )}
      {...props}
    >
      {withHandle ? <div className="z-10 h-1 w-8 rounded-full bg-zinc-500" /> : null}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
