// Remaps the LiNMC test data to the Setup 1 channel layout expected by the Kalman filter.
// In this dataset ch0 measured the battery discharge current (same path as the load on ch1),
// and the battery current sensor (ch2) was not connected. There was no MPPT.
//
//   new ch0 (MPPT out)   = 32768 (0 A)
//   new ch1 (Load in)    = ch1
//   new ch2 (Batt1 net)  = old ch0
//   ch3 - ch7            = unchanged
//
// Usage: node remap_linmc.js [input_folder] [output_folder]

const fs = require('fs');
const path = require('path');

const ADC_ZERO_CURRENT = 32768;     // Bipolar ADC reading for 0 A (see adc_converter.js)

const input_dir = path.resolve(__dirname, process.argv[2] || 'LiNMC');
const output_dir = path.resolve(__dirname, process.argv[3] || 'LiNMC Remapped');

if (input_dir === output_dir) {
    throw new Error('Output folder must be different from input folder.');
}
fs.mkdirSync(output_dir, { recursive: true });

const files = fs.readdirSync(input_dir).filter(file => file.endsWith('.csv'));
for (const file of files) {
    const lines = fs.readFileSync(path.join(input_dir, file), 'utf8').split(/\r?\n/);
    const header = lines[0].split(',');
    const col = name => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`${file}: missing column ${name}`);
        return i;
    };
    const ch0 = col('ch0'), ch1 = col('ch1'), ch2 = col('ch2');

    const out = [lines[0]];
    for (const line of lines.slice(1)) {
        if (!line) continue;
        const values = line.split(',');
        const battery_current = values[ch0];
        values[ch0] = ADC_ZERO_CURRENT;
        values[ch2] = battery_current;
        out.push(values.join(','));
    }

    fs.writeFileSync(path.join(output_dir, file), out.join('\n') + '\n');
    console.log(`${file}: ${out.length - 1} rows remapped`);
}
console.log(`Done. ${files.length} files written to ${output_dir}`);
