import { expect, test } from 'bun:test'
import { labelColorOf } from './colors'

test("GitHub's default label colours land on the nearest colour here", () => {
  expect(labelColorOf('d73a4a')).toBe('red') // bug
  expect(labelColorOf('0075ca')).toBe('blue') // documentation
  expect(labelColorOf('cfd3d7')).toBe('gray') // duplicate
  expect(labelColorOf('a2eeef')).toBe('blue') // enhancement
  expect(labelColorOf('7057ff')).toBe('purple') // good first issue
  expect(labelColorOf('008672')).toBe('green') // help wanted
  expect(labelColorOf('e4e669')).toBe('yellow') // invalid
  expect(labelColorOf('d876e3')).toBe('purple') // question
  expect(labelColorOf('ffffff')).toBe('gray') // wontfix
  expect(labelColorOf('#f9a03f')).toBe('orange')
  expect(labelColorOf('not a colour')).toBe('gray')
})
