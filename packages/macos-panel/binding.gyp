{
  "targets": [
    {
      "target_name": "macos_panel",
      "conditions": [
        [
          "OS==\"mac\"",
          {
            "sources": [
              "src/panel.mm"
            ],
            "xcode_settings": {
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "MACOSX_DEPLOYMENT_TARGET": "11.0"
            },
            "link_settings": {
              "libraries": [
                "-framework AppKit"
              ]
            }
          },
          {
            "type": "none"
          }
        ]
      ]
    }
  ]
}
