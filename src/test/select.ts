import { fireEvent, screen, within } from '@testing-library/react';

/** Exercise the visible selection control, including its open/choose/close behavior. */
export function selectValue(control: HTMLElement, value: string) {
  fireEvent.click(control);
  const options = within(screen.getByRole('listbox')).getAllByRole('option');
  const option = options.find(option => (option as HTMLButtonElement).value === value);
  if (!option) throw new Error(`Option ${value} was not found`);
  fireEvent.click(option);
}
