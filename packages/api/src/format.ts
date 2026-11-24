import { format } from 'oxfmt'

export async function formatSource(
  fileName: string,
  text: string,
): Promise<string> {
  const { code, errors } = await format(fileName, text, {
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 80,
  })
  const failure = errors.find((e) => e.severity === 'Error')
  if (failure) throw new Error(`${fileName}: ${failure.message}`)
  return code
}
