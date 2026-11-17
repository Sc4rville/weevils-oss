// The user's own words are context, never weevils' idea: restatements and « You want… » openers are recognised,
// a genuinely new suggestion tied to the same goal is not.
import { describe, expect, it } from 'vitest'
import { echoesUser, ownIdea, ownTask, restated } from './own-words.ts'

const memory = [
  'wants to make the weevils app open source by Friday, with first access given to whoever responds to his announcement tweet',
  'Wants the weevils project pinned on the main page of the app.',
  'veut tourner des sketchs avec son avatar d’ici vendredi',
  'wants to ship mygame this year',
]

describe('own words', () => {
  it('recognises the card that handed Yann his own decision back (« First access reply »)', () => {
    const card = { title: 'First access reply', text: 'You want to give first access to people who reply to your announcement tweet. I suggest preparing a short reply with the installer link and a request to report where they get stuck.' }
    expect(ownIdea(card, memory)).not.toBeNull()
    // Without the « You want » opener, the restatement alone is enough.
    expect(restated('Give first access to the people who reply to your announcement tweet.', memory)).toBe(memory[0])
  })

  it('catches « You want… / Tu veux… » wherever a clause starts', () => {
    expect(echoesUser('You want For you cards coloured by project.')).toBe(true)
    expect(echoesUser('Your demo is live, and you want to announce the launch.')).toBe(true)
    expect(echoesUser('Tu veux tourner avec ton avatar d’ici vendredi.')).toBe(true)
    expect(echoesUser('Tu as déjà une bêta vierge, et tu veux un socle installable.')).toBe(true)
    expect(echoesUser('Tu envisages l’entertainment et les outils pour créer.')).toBe(true)
    expect(echoesUser('Tap it if you want, the draft stays private.')).toBe(false)
    expect(echoesUser('Your launch trailer lost full-size frames when RunPod credit ran out.')).toBe(false)
  })

  it('lets a new idea through, even tied to the same goal', () => {
    expect(ownIdea({ title: 'Keep renders after RunPod stops', text: 'Your launch trailer lost full-size frames when RunPod credit ran out. I suggest a save step that copies each render to the VPS.' }, memory)).toBeNull()
    expect(ownIdea({ title: 'Catch broken saves', text: 'Two mygame sessions were cut off while editing the save code. A test that loads an old save would catch a break before release.' }, memory)).toBeNull()
    expect(ownIdea({ title: 'Pick your launch excerpt', text: 'Your four weevils films are finished. I suggest preparing a shortlist of three excerpts, with timestamps.' }, memory)).toBeNull()
  })

  it('a clause restating the memory is caught inside a longer sentence', () => {
    const said = ['Keeps raw content ideas in the private Sc4rville/content repo, organised by project.']
    expect(restated('You keep raw ideas in the content repo and want your videos recorded by Friday, so an index would help.', said)).toBe(said[0])
  })

  it('a long message does not match a short sentence by sheer volume', () => {
    const long = 'Ok so today I looked at the installer, the landing page, the trailer, the tests, the release notes, the pricing, the docs and the screenshots, and the tweet thread for the launch with friends.'
    expect(restated('The installer link on the landing page is broken.', [long])).toBeNull()
  })

  it('an auto task says honestly when it carries out the user’s own idea', () => {
    expect(ownTask({ title: 'Pin weevils project on main', why: 'you want it at the top' }, memory)).toEqual({ own: true, why: '' })
    expect(ownTask({ title: 'Pin weevils project on main', why: 'Your idea: the weevils project first on the main page.' }, memory)).toEqual({ own: true, why: null })
    // A new task whose why only hands the goal back keeps its title, loses the parroting why.
    expect(ownTask({ title: 'Harden the save tests', why: 'You want to ship mygame this year.' }, memory)).toEqual({ own: false, why: '' })
    expect(ownTask({ title: 'Harden the save tests', why: 'A broken save would go unnoticed before mygame ships.' }, memory)).toEqual({ own: false, why: null })
  })
})
