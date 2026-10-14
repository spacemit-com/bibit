import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearComposeSkills,
  stageComposeSkills,
  takeComposeSkills,
} from '../pendingComposeSkills'

const skill = (id: string) => ({
  id,
  name: id,
  display_name: id,
  description: '',
  version: '1',
  origin: 'plugin',
})

beforeEach(() => clearComposeSkills())

describe('预置技能交接', () => {
  it('取走即清，第二次为空', () => {
    stageComposeSkills('worker', [skill('a')])
    expect(takeComposeSkills('worker')).toHaveLength(1)
    expect(takeComposeSkills('worker')).toEqual([])
  })

  it('目标不符时不取走，留给匹配的目标', () => {
    stageComposeSkills('worker', [skill('a')])
    expect(takeComposeSkills('other')).toEqual([])
    expect(takeComposeSkills('worker')).toHaveLength(1)
  })
})
