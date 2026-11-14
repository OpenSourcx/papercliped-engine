/**
 * A problem with an action's arguments or with what it would touch, in words the model and the person can use. Lives in its
 * own module so actions defined in other files can throw it without importing the table of actions.
 */
export class ActProblem extends Error {
  readonly code = "bad_action";
  constructor(message: string) {
    super(message);
  }
}
