import { HouseIcon } from '@phosphor-icons/react'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { BrandMark } from '~/components/brand-mark'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="-my-1.5 inline-flex items-center gap-2 py-1.5 text-base font-bold tracking-[-0.02em]">
          <BrandMark className="h-5 w-4" />
          cobalt
        </span>
      ),
      url: '/',
    },
    themeSwitch: { enabled: false },
    links: [{ text: 'Home', url: '/', icon: <HouseIcon /> }],
  }
}
