import assert from 'node:assert/strict';

export default {
  name: 'bot-avatar-crop',
  entry: './bot-avatar-crop-fixture.tsx',
  viewport: { width: 720, height: 640 },
  real: 'BotPortraitPicker upload entry, account AvatarCropEditor, real image decode, crop geometry and export',
  notCovered: 'Full app navigation, main-process persistence, remote device transport and Mobile',
  cases: {
    default: { about: 'Upload, drag/zoom, confirm, cancel, repeat selection and invalid image' },
  },
  async check(page, ui) {
    const initial = await page.getByTestId('avatar-result').textContent();
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a6b46';
      ctx.fillRect(0, 0, 400, 400);
      ctx.fillStyle = '#da9b36';
      ctx.fillRect(400, 0, 400, 400);
      return canvas.toDataURL();
    });
    const file = {
      name: 'wide.png',
      mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
    };
    const upload = async (image = file) => {
      await page
        .getByRole('button', { name: await ui.t('bots.profile.changeAvatar'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await ui.t('bots.guided.upload'), exact: true })
        .click();
      await page.locator('input[type=file]').setInputFiles(image);
    };
    await upload();
    const stage = page.getByRole('group', {
      name: await ui.t('settings.userProfile.edit.crop.stageLabel'),
    });
    await stage.waitFor();
    await page
      .getByRole('button', {
        name: await ui.t('settings.userProfile.edit.crop.zoomIn'),
        exact: true,
      })
      .click();
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.getByTestId('avatar-result').textContent(), initial);
    await ui.capture('crop');
    await page
      .getByRole('button', { name: await ui.t('settings.userProfile.edit.crop.done'), exact: true })
      .click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    const result = await page.getByTestId('avatar-result').textContent();
    assert.notEqual(result, initial);
    assert.notEqual(result, dataUrl);
    const size = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, result);
    assert.equal(size[0], size[1]);
    assert.ok(size[0] > 0 && size[0] < 400);
    await ui.capture('confirmed');
    await upload();
    await stage.waitFor();
    await page
      .getByRole('button', { name: await ui.t('settings.userProfile.edit.cancel'), exact: true })
      .click();
    assert.equal(await page.getByTestId('avatar-result').textContent(), result);
    await upload({
      name: 'broken.png',
      mimeType: 'image/png',
      buffer: Buffer.from('invalid image'),
    });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.getByTestId('avatar-result').textContent(), result);
  },
};
