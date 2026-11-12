import type { CSSProperties } from 'react';

export function SkeletonLoader() {
  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-ground)]">
      {/* Sidebar skeleton */}
      <aside className="hidden w-[240px] flex-shrink-0 flex-col gap-4 px-3 py-3 md:flex">
        <div className="flex h-9 items-center gap-2 px-1">
          <SkeletonBlock width={28} height={28} radius="8px" />
          <SkeletonBlock width={92} height={14} />
        </div>
        <SkeletonBlock width="100%" height={40} radius="10px" />
        <div className="mt-2 space-y-1">
          <div className="px-2 pb-1">
            <SkeletonBlock width={56} height={12} />
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex h-9 items-center gap-2.5 px-2">
              <SkeletonBlock width={16} height={16} radius="4px" />
              <SkeletonBlock width={`${48 + ((i * 13) % 32)}%`} height={12} />
            </div>
          ))}
        </div>
        <div className="mt-auto space-y-1 border-t border-[rgba(0,0,0,0.05)] pt-3">
          <SkeletonBlock width="100%" height={40} radius="10px" />
        </div>
      </aside>

      {/* Main card */}
      <main className="m-2 ml-0 flex min-w-0 flex-1 overflow-hidden rounded-[12px] border border-[rgba(0,0,0,0.05)] bg-white">
        {/* Mail list skeleton */}
        <div className="mail-list-pane flex flex-col border-r border-[rgba(0,0,0,0.06)] p-3">
          <div className="px-1 pb-3">
            <SkeletonBlock width={72} height={18} />
          </div>
          <SkeletonBlock width="100%" height={36} radius="10px" />
          <div className="mt-3 flex-1 space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-[rgba(0,0,0,0.04)] px-1 py-3.5 last:border-b-0">
                <SkeletonBlock width={36} height={36} radius="50%" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <SkeletonBlock width="42%" height={12} />
                    <SkeletonBlock width={38} height={10} />
                  </div>
                  <SkeletonBlock width={`${62 + ((i * 7) % 22)}%`} height={12} />
                  <SkeletonBlock width="86%" height={10} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Reading panel skeleton */}
        <div className="hidden min-w-0 flex-1 flex-col p-8 lg:flex">
          <div className="mx-auto w-full max-w-[780px]">
            <SkeletonBlock width="70%" height={22} />
            <div className="mt-5 flex items-center gap-3">
              <SkeletonBlock width={36} height={36} radius="50%" />
              <div className="space-y-2">
                <SkeletonBlock width={120} height={12} />
                <SkeletonBlock width={200} height={10} />
              </div>
            </div>
            <div className="mt-8 space-y-3.5 border-t border-[rgba(0,0,0,0.06)] pt-6">
              {Array.from({ length: 7 }).map((_, i) => (
                <SkeletonBlock key={i} width={`${68 + ((i * 9) % 30)}%`} height={13} />
              ))}
              <div className="h-3" />
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonBlock key={`b-${i}`} width={`${60 + ((i * 11) % 35)}%`} height={13} />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function SkeletonBlock({ width, height, radius = '6px' }: {
  width: string | number;
  height: string | number;
  radius?: string;
}) {
  const style: CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: radius,
  };
  return <span className="sk" style={style} aria-hidden="true" />;
}
