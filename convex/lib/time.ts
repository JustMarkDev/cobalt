export const now = () => Date.now()

export const iso = (ms: number) => new Date(ms).toISOString()

export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7)
