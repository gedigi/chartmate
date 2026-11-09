import { expect, test } from '@playwright/test';

// The connect flow itself talks to GitHub and is covered by the server's and the web app's unit tests (with a fake
// repository); here the built app shows the dialog, and the server reports sync as off without leaking anything.
test('Sync opens from the top bar: off, with the steps and the two fields', async ({ page, request }) => {
  expect(await (await request.get('/api/sync')).json()).toEqual({ source: null, repo: null, lastSyncAt: null, lastError: null });
  expect(await (await request.post('/api/sync/run')).json()).toBeNull();
  await page.goto('/');
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync' });
  await expect(dialog).toContainText('private GitHub repository you own');
  await expect(dialog.getByLabel('Repository')).toBeVisible();
  await expect(dialog.getByLabel('Token')).toHaveAttribute('type', 'password');
  await expect(dialog.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
