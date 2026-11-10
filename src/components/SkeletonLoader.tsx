import { motion } from 'motion/react';

export function SkeletonLoader() {
  return (
    <div className="flex-1 flex h-full overflow-hidden">
      {/* Sidebar skeleton */}
      <div className="w-[248px] bg-[var(--color-bg-sidebar)] border-r border-[var(--color-border-default)] p-4 space-y-4">
        <SkeletonBlock width="60%" height={16} />
        <SkeletonBlock width="100%" height={36} />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} width="80%" height={14} />
          ))}
        </div>
      </div>

      {/* Mail list skeleton */}
      <div className="w-[360px] border-r border-[var(--color-border-default)] p-4 space-y-3">
        <SkeletonBlock width="100%" height={32} />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 py-3">
            <SkeletonBlock width={36} height={36} rounded />
            <div className="flex-1 space-y-2">
              <SkeletonBlock width="60%" height={12} />
              <SkeletonBlock width="80%" height={12} />
              <SkeletonBlock width="40%" height={10} />
            </div>
          </div>
        ))}
      </div>

      {/* Reading panel skeleton */}
      <div className="flex-1 p-6 space-y-4">
        <SkeletonBlock width="70%" height={20} />
        <div className="flex items-center gap-3">
          <SkeletonBlock width={40} height={40} rounded />
          <div className="space-y-2">
            <SkeletonBlock width={120} height={12} />
            <SkeletonBlock width={200} height={10} />
          </div>
        </div>
        <div className="space-y-3 pt-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} width={`${70 + Math.random() * 30}%`} height={14} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SkeletonBlock({ width, height, rounded = false }: { width: string | number; height: string | number; rounded?: boolean }) {
  return (
    <motion.div
      animate={{ opacity: [0.4, 0.7, 0.4] }}
      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: rounded ? '50%' : '6px',
        background: 'var(--color-bg-hover)',
      }}
    />
  );
}
