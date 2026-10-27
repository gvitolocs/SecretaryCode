# Mac image viewer

Secretary Code opens Finder images in Lucina's existing viewer at
<https://getsecretary.tech/viewer>. Its `persist:lucina-web` cookie session is shared
by viewer windows. If the network, page, or web sign-in is unavailable, a built-in
page displays the local image and offers **Sign in to Lucina**. Signing in in that
window keeps the web cookie in this partition; reopen the image afterward.

Use **Window → Open with Preview** or **⌘⇧P** for formats Chromium cannot display.
Camera RAW files open directly in Preview. The offline page uses the Mac's image
conversion tools for HEIC, HEIF, TIFF and BMP. SVG and ordinary browser image
formats are read directly from disk. Local viewing does not upload files; **Save
to Lucina** in the web viewer uploads through your signed-in web session.

## Make Secretary Code the default

Install and launch the production Mac app (bundle ID `app.secretary.code`) first.
With [duti](https://github.com/moretension/duti) installed (`brew install duti`), run:

```sh
duti -s app.secretary.code public.jpeg viewer
duti -s app.secretary.code public.png viewer
duti -s app.secretary.code public.heic viewer
duti -s app.secretary.code public.heif viewer
duti -s app.secretary.code com.compuserve.gif viewer
duti -s app.secretary.code org.webmproject.webp viewer
duti -s app.secretary.code public.tiff viewer
duti -s app.secretary.code com.microsoft.bmp viewer
duti -s app.secretary.code public.svg-image viewer
duti -s app.secretary.code public.camera-raw-image viewer
```

One-line revert to Preview:

```sh
for uti in public.jpeg public.png public.heic public.heif com.compuserve.gif org.webmproject.webp public.tiff com.microsoft.bmp public.svg-image public.camera-raw-image; do duti -s com.apple.Preview "$uti" viewer; done
```

Finder alternative: select an image, choose **Get Info**, expand **Open with**,
choose **Secretary Code**, then click **Change All…**. Repeat for each image type.

## Local access and identity

Each window gets a random in-memory token for one folder. Only image files directly
inside that folder can be read, and symlinks outside it are refused. Closing the
window revokes its token. Folder images use case-insensitive natural order, capped
at 2,000 around the clicked image. The file path's SHA-256 is its Lucina asset ID;
the filesystem birth time is passed as `takenAt`.

The `mac-<uuid>` device identity is encrypted with Electron safeStorage in
`userData/lucina-device`; the Mac's ComputerName supplies the display name. The viewer
session extends only the hosted page's image and fetch CSP directives to permit
`secretary-file:` resources.

## Mac release verification

Build the production app and inspect `Contents/Info.plist` document types. Test
Finder cold launch, multiple selection, an already-running app, natural sibling
navigation, close/Esc, and the menu/⌘⇧P Preview action. Test signed-in and signed-out
web sessions and airplane mode, including HEIC and RAW. Confirm **Save to Lucina**
uploads successfully and the device identity stays the same after restarting.
