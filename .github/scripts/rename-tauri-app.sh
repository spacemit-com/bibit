#!/bin/bash

# Check if the correct number of arguments is provided
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <path_to_json_input_file> <channel>"
    exit 1
fi

INPUT_JSON_FILE="$1"

CHANNEL="$2"

# Check if the input file exists
if [ ! -f "$INPUT_JSON_FILE" ]; then
    echo "Input file not found: $INPUT_JSON_FILE"
    exit 1
fi

# Use jq to transform the content
jq --arg channel "$CHANNEL" '
    .productName = "BiBit-\($channel)" |
    .identifier = "com.dc.bibit.gui.\($channel)"
' "$INPUT_JSON_FILE" > ./tauri.conf.json.tmp

cat ./tauri.conf.json.tmp

rm $INPUT_JSON_FILE
mv ./tauri.conf.json.tmp $INPUT_JSON_FILE

# Update Info.plist if it exists
INFO_PLIST_PATH="./src-tauri/Info.plist"
if [ -f "$INFO_PLIST_PATH" ]; then
    echo "Updating Info.plist..."
    
    # Add the channel suffix to the BiBit bundle identifier
    sed -i '' "s|com\.dc\.bibit\.gui|com.dc.bibit.gui.${CHANNEL}|g" "$INFO_PLIST_PATH"
    
    # Add the channel suffix to the BiBit URL scheme
    sed -i '' "s|<string>bibit</string>|<string>bibit-${CHANNEL}</string>|g" "$INFO_PLIST_PATH"

    echo "Info.plist updated"

    cat ./src-tauri/Info.plist
fi
# Update the layout file
# LAYOUT_FILE_PATH="web/app/layout.tsx"

# if [ ! -f "$LAYOUT_FILE_PATH" ]; then
#     echo "File does not exist: $LAYOUT_FILE_PATH"
#     exit 1
# fi

# Perform the replacements
# sed -i -e "s#Jan#Jan-$CHANNEL#g" "$LAYOUT_FILE_PATH"

# Notify completion
# echo "File has been updated: $LAYOUT_FILE_PATH"
