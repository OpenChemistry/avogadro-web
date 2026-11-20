cmake_minimum_required(VERSION 3.19)
project(AvogadroWeb LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

include(GNUInstallDirs)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()
if(NOT CMAKE_RUNTIME_OUTPUT_DIRECTORY)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
endif()
option(ENABLE_TESTING "Build the web controller regression tests" OFF)
if(ENABLE_TESTING)
  enable_testing()
endif()

find_package(AvogadroLibs REQUIRED NO_MODULE)
find_package(Eigen3 REQUIRED)
find_package(Qt6 REQUIRED COMPONENTS Widgets OpenGL OpenGLWidgets)
if(NOT DEFINED AvogadroLibs_USE_SUBPROCESS OR AvogadroLibs_USE_SUBPROCESS)
  message(FATAL_ERROR "Build avogadrolibs with USE_SUBPROCESS=OFF")
endif()
if(NOT AvogadroLibs_USE_OPENGL OR NOT AvogadroLibs_BUILD_STATIC_PLUGINS)
  message(FATAL_ERROR "Build avogadrolibs with USE_OPENGL=ON and BUILD_STATIC_PLUGINS=ON")
endif()

add_library(AvogadroWebController STATIC src/webcontroller.cpp src/webcontroller.h)
set_target_properties(AvogadroWebController PROPERTIES AUTOMOC ON)
target_link_libraries(AvogadroWebController PUBLIC Avogadro::QtGui Avogadro::QtOpenGL Avogadro::QtPlugins Eigen3::Eigen)
target_include_directories(AvogadroWebController PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
qt_add_executable(avogadro-web src/main.cpp)
target_link_libraries(avogadro-web PRIVATE AvogadroWebController)

if(EMSCRIPTEN)
  target_link_options(avogadro-web PRIVATE --bind -sDYNAMIC_EXECUTION=0 -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2)
  if(ENABLE_TESTING)
    target_compile_definitions(avogadro-web PRIVATE AVOGADRO_WASM_BROWSER_TESTS)
  endif()
  set_target_properties(avogadro-web PROPERTIES QT_WASM_EXPORT_NAME createAvogadroWeb)
  # qt_add_executable deploys the loader and Emscripten auxiliary files.
  foreach(asset index.html editor.js editor.css molecule-import.js share-link.js)
    configure_file("web/editor/${asset}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/${asset}" COPYONLY)
  endforeach()
  foreach(asset_dir data icons)
    file(MAKE_DIRECTORY "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/${asset_dir}")
    file(GLOB_RECURSE assets CONFIGURE_DEPENDS RELATIVE "${CMAKE_CURRENT_SOURCE_DIR}/web/editor"
      "web/editor/${asset_dir}/*")
    foreach(asset IN LISTS assets)
      if(NOT asset MATCHES "/[.]gitkeep$")
        configure_file("web/editor/${asset}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/${asset}" COPYONLY)
      endif()
    endforeach()
  endforeach()
  install(DIRECTORY web/editor/data web/editor/icons
    DESTINATION share/avogadro-web
    PATTERN ".gitkeep" EXCLUDE)
  if(QT_FEATURE_thread)
    set(AVOGADRO_WEB_WASM_KIT wasm_multithread)
  else()
    set(AVOGADRO_WEB_WASM_KIT wasm_singlethread)
  endif()
  configure_file(web/core/avogadro-editor.js "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/core/avogadro-editor.js" @ONLY)
  if(NOT QT_FEATURE_thread)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    set(offline_page "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/avogadro-offline.html")
    set(offline_generator "${CMAKE_CURRENT_SOURCE_DIR}/tools/make-offline.py")
    add_custom_command(
      OUTPUT "${offline_page}"
      COMMAND "${Python3_EXECUTABLE}" "${offline_generator}" "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}"
        --kit "${AVOGADRO_WEB_WASM_KIT}"
      DEPENDS avogadro-web "${offline_generator}"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/index.html"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/editor.js"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/molecule-import.js"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/share-link.js"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/editor.css"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/core/avogadro-editor.js"
        "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/icons/avogadro2.svg"
      VERBATIM)
    add_custom_target(avogadro-web-offline ALL DEPENDS "${offline_page}")
    install(FILES "${offline_page}" DESTINATION share/avogadro-web)
  endif()
  configure_file(tools/serve-wasm.py "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/serve-wasm.py" COPYONLY)
  install(FILES README.md DESTINATION share/avogadro-web)
  install(FILES docs/self-hosting.md DESTINATION share/avogadro-web/docs)
  install(FILES docs/images/workspace.png DESTINATION share/avogadro-web/docs/images)
  find_program(AVOGADRO_GZIP_EXECUTABLE gzip)
  if(AVOGADRO_GZIP_EXECUTABLE)
    add_custom_command(TARGET avogadro-web POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE_DIR:avogadro-web>/avogadro-web.wasm" "$<TARGET_FILE_DIR:avogadro-web>/avogadro-web.wasm.compress"
      COMMAND ${AVOGADRO_GZIP_EXECUTABLE} -9 -f "$<TARGET_FILE_DIR:avogadro-web>/avogadro-web.wasm.compress"
      COMMAND ${CMAKE_COMMAND} -E rename "$<TARGET_FILE_DIR:avogadro-web>/avogadro-web.wasm.compress.gz" "$<TARGET_FILE_DIR:avogadro-web>/avogadro-web.wasm.gz"
      VERBATIM)
  endif()
  install(DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY}/ DESTINATION share/avogadro-web
    FILES_MATCHING PATTERN "*.js" PATTERN "*.wasm" PATTERN "*.wasm.gz"
    PATTERN "*.data" PATTERN "index.html" PATTERN "*.css" PATTERN "serve-wasm.py")
else()
  install(TARGETS avogadro-web RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()
if(ENABLE_TESTING AND NOT EMSCRIPTEN)
  find_package(GTest REQUIRED)
  find_package(Qt6 REQUIRED COMPONENTS Test)
  add_executable(AvogadroWebTests tests/native/webcontroller.cpp)
  target_link_libraries(AvogadroWebTests PRIVATE AvogadroWebController GTest::gtest Qt6::Test)
  add_test(NAME WebEditor COMMAND AvogadroWebTests)
  set_tests_properties(WebEditor PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
endif()
