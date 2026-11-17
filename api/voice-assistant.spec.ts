import { describe, expect, it } from 'vitest'
import { findInformation, getStep } from './voice-assistant'

describe('findInformation', () => {
  const ingredients = ['2 cups flour', '1 tsp salt', '3 eggs']

  it('lists everything when asked for all ingredients', () => {
    expect(findInformation('what are all the ingredients', ingredients)).toBe("You'll need: 2 cups flour, 1 tsp salt, 3 eggs.")
    expect(findInformation('list the ingredients', ingredients)).toContain('3 eggs')
  })

  it('says so when there are no ingredients', () => {
    expect(findInformation('all ingredients', [])).toBe("This recipe doesn't have any ingredients listed.")
  })

  it('finds a single ingredient by keyword', () => {
    expect(findInformation('how much flour', ingredients)).toBe("You'll need: 2 cups flour.")
  })

  it('is case-insensitive', () => {
    expect(findInformation('HOW MANY EGGS', ingredients)).toBe("You'll need: 3 eggs.")
  })

  it('does not answer things that are not in the recipe', () => {
    const none = "I couldn't find that in this recipe."
    expect(findInformation('how much butter', ingredients)).toBe(none)
    expect(findInformation('how much', ingredients)).toBe(none) // only stop words
    expect(findInformation('', ingredients)).toBe(none)
    expect(findInformation(undefined, ingredients)).toBe(none)
    expect(findInformation(42, ingredients)).toBe(none)
  })
})

describe('getStep', () => {
  const steps = ['Chop', 'Fry', 'Serve']

  it('reads the current step', () => {
    expect(getStep('current', 0, steps)).toEqual({ speech: 'Step 1. Chop', newStep: 0, finished: false })
  })

  it('moves forward and back', () => {
    expect(getStep('next', 0, steps)).toMatchObject({ newStep: 1, speech: 'Step 2. Fry' })
    expect(getStep('previous', 2, steps)).toMatchObject({ newStep: 1, speech: 'Step 2. Fry' })
  })

  it('does not go before the first step', () => {
    expect(getStep('previous', 0, steps)).toMatchObject({ newStep: 0, speech: 'Step 1. Chop', finished: false })
  })

  it('finishes after the last step and stays there', () => {
    const result = getStep('next', 2, steps)
    expect(result).toMatchObject({ newStep: 3, finished: true })
    expect(getStep('next', 3, steps).newStep).toBe(3)
  })

  it('treats an unknown direction as "current"', () => {
    expect(getStep('sideways', 1, steps)).toMatchObject({ newStep: 1, speech: 'Step 2. Fry' })
    expect(getStep(undefined, 1, steps).newStep).toBe(1)
  })

  it('handles a recipe with no steps', () => {
    expect(getStep('current', 0, [])).toMatchObject({ finished: true })
  })
})
