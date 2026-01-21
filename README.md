# Picking Console Size Calculator

A Firefox browser extension that calculates average item weights for picking batches by fetching data from Rodeo and FC Research.

## Features

- Adds an "Avg Weight" column to the Picking Console batch table
- Fetches FN SKUs for each batch from Rodeo
- Gets item weights from FC Research
- Calculates and displays average, min, max, and total weights
- Caches weight data to minimize API calls (30-minute cache)
- Floating control panel for batch operations
- Color-coded weight display (light/normal/heavy)

## How It Works

1. **Picking Console**: Detects batch IDs in the table and adds a weight column
2. **Rodeo**: Fetches all FN SKUs associated with a batch ID
3. **FC Research**: Retrieves the weight in pounds for each FN SKU
4. **Calculation**: Averages the weights and displays results

## Installation

### Firefox (Temporary Load for Development)

1. Clone this repository
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" in the left sidebar
4. Click "Load Temporary Add-on..."
5. Navigate to the `extension` folder and select `manifest.json`

### Firefox (Permanent Installation)

1. Package the extension: `cd extension && zip -r ../picking-console-size.xpi *`
2. In Firefox, go to `about:addons`
3. Click the gear icon and select "Install Add-on From File..."
4. Select the `.xpi` file

## Usage

1. Open the [Picking Console](https://picking-console.na.picking.aft.a2z.com) with MultiSlamPicking filter
2. You'll see a floating "Size Calculator" panel in the top-right corner
3. Each batch row now has a weight column with a ⚖️ button
4. Click the button to fetch the average weight for that specific batch
5. Or click "Fetch All Weights" to process all visible batches

### Weight Display

- **Green background**: Light items (< 0.5 lbs)
- **Blue background**: Normal items (0.5 - 2 lbs)
- **Orange background**: Heavy items (> 2 lbs)

Hover over any weight to see detailed stats:
- Total weight for all items
- Number of items
- Min/Max individual weights
- Number of unique SKUs

## Permissions

The extension requires access to:
- `picking-console.na.picking.aft.a2z.com` - To add the weight column
- `rodeo-iad.amazon.com` - To fetch FN SKUs for batches
- `fcresearch-na.aka.amazon.com` - To fetch item weights

## Project Structure

```
extension/
├── manifest.json           # Extension configuration
├── background.js           # API coordination and caching
├── content/
│   ├── pickingConsole.js   # Main UI and batch table enhancement
│   ├── pickingConsole.css  # Styling for the floating panel
│   ├── rodeo.js            # Rodeo page helper
│   └── fcresearch.js       # FC Research page helper
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.css           # Popup styling
│   └── popup.js            # Popup logic
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

## Development

To modify the extension:

1. Make changes to the source files
2. In Firefox `about:debugging`, click "Reload" on the extension
3. Refresh the Picking Console page to see changes

### Debugging

- Open the browser console (F12) to see log messages prefixed with `[PickingConsole]`, `[Rodeo]`, `[FCResearch]`, or `[Background]`
- Check the extension's background page console via `about:debugging` > Inspect

## Author

Ca3de

## License

MIT
